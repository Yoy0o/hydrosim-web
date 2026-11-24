/**
 * WebGPU engine: runs the shallow-water scheme as compute shaders (see kernels.ts).
 *
 * A batch encodes many time steps in one compute pass. dt, source integrals, boundary levels and record
 * events are computed on the GPU; records (probes, sections, global sums) are written to a ring buffer.
 * After each batch the CPU reads back the control block, the per-step dt history (summed in double
 * precision to keep simulation time exact), the records and optionally the fields for rendering.
 */
import { boundaryLevel, SIDES, WIND_MIN_DEPTH, type BoundarySpec, type SolverParams, type SourceSpec } from '../core/solver';
import { sampleSeries } from '../core/timeseries';
import type { ProbeSpec, RecordRow, SectionSpec } from '../worker/protocol';
import type { AdvanceResult, Engine, EngineInit, EngineStats, EnvelopeData, Fields } from '../worker/engine';
import * as K from './kernels';

const WG = 256;
const MAX_STEPS = 1024;
const BUF = { S: 0x80, CD: 0x08, CS: 0x04, U: 0x40, I: 0x100, MR: 0x01 }; // GPUBufferUsage flags

type PipeName =
  | 'bc'
  | 'slopes'
  | 'flux1'
  | 'flux2a'
  | 'flux2b'
  | 'scalar'
  | 'bflux'
  | 'bfluxH'
  | 'update0'
  | 'update1'
  | 'update2'
  | 'stats'
  | 'finalize'
  | 'copyU0'
  | 'pack'
  | 'zline';

function flatten(s: [number, number][]): number[] {
  const out: number[] = [];
  for (const [t, v] of s) out.push(t, v);
  return out;
}

export class GpuEngine implements Engine {
  readonly kind = 'gpu' as const;
  readonly label: string;
  private readonly dev: GPUDevice;
  readonly nx: number;
  readonly ny: number;
  readonly dx: number;
  readonly dy: number;
  private readonly NX: number;
  private readonly N: number;
  private readonly nXI: number;
  private readonly nYI: number;
  private readonly nCells: number;
  private readonly nBnd: number;
  private readonly statsGroups: number;
  private readonly z: Float32Array;
  private params: SolverParams;
  private extra: SourceSpec[] = [];
  private probes: ProbeSpec[];
  private sections: SectionSpec[];
  private recordInterval: number;
  private nextRecord = 0;
  private _t = 0;
  private _steps = 0;
  private lastDt = 0;
  private volume0 = 0;
  private totals = { rain: 0, inflow: 0, infil: 0, clip: 0, bIn: 0, bOut: 0 };
  private lastRow: RecordRow;
  private lastStats: EngineStats;
  private msPerStep = 0;
  private recFloats = K.REC_HEADER;
  private nSources = 0;
  private nLinks = 0;
  private nLines = 0;
  private nLineCells = 0;
  private dirtyManning = true;
  private buf: Record<string, GPUBuffer> = {};
  private pipes = {} as Record<PipeName, GPUComputePipeline>;
  private groups = {} as Record<PipeName, GPUBindGroup>;
  private staging: GPUBuffer | null = null;
  private stagingSize = 0;
  private dirtySeries = true;
  private dirtyObs = true;
  private dirtyGroups = true;
  private order2Ready = false;
  private lostReason: string | null = null;
  private h0: Float32Array;

  private constructor(dev: GPUDevice, label: string, init: EngineInit, pipes: Record<PipeName, GPUComputePipeline>) {
    this.dev = dev;
    this.label = label;
    this.pipes = pipes;
    const { nx, ny, dx, dy } = init.grid;
    this.nx = nx;
    this.ny = ny;
    this.dx = dx;
    this.dy = dy;
    this.NX = nx + 4;
    this.N = (nx + 4) * (ny + 4);
    this.nXI = (nx + 1) * ny;
    this.nYI = nx * (ny + 1);
    this.nCells = nx * ny;
    this.nBnd = 2 * (nx + ny);
    this.statsGroups = Math.ceil(this.nCells / WG);
    this.z = init.z.slice();
    this.params = init.params;
    this.probes = init.probes;
    this.sections = init.sections;
    this.recordInterval = init.recordInterval;
    this.h0 = init.h0;
    const mk = (name: string, size: number, usage: number): void => {
      this.buf[name] = dev.createBuffer({ label: name, size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    };
    mk('P', K.PARAMS_BYTES, BUF.U | BUF.CD);
    mk('U', 16 * this.N, BUF.S | BUF.CD | BUF.CS);
    mk('F', 16 * (this.nXI + this.nYI), BUF.S);
    mk('R', 16 * (this.nXI + this.nYI), BUF.S);
    mk('C', K.CTRL_BYTES, BUF.S | BUF.CD | BUF.CS);
    mk('ENV', 16 * this.nCells, BUF.S | BUF.CD | BUF.CS);
    mk('ACC', 8 * this.nCells, BUF.S | BUF.CD);
    mk('BACC', 8 * this.nBnd, BUF.S | BUF.CD);
    mk('PART', 32 * this.statsGroups, BUF.S);
    mk('DTH', 4 * MAX_STEPS, BUF.S | BUF.CS);
    mk('IND', 32, BUF.S | BUF.I | BUF.CD);
    mk('PACK', 12 * this.nCells, BUF.S | BUF.CS);
    mk('DUMMY', 64, BUF.S);
    this.lastStats = this.emptyStats();
    this.lastRow = this.emptyRow();
    dev.lost.then((info) => {
      this.lostReason = info.message || 'GPU 设备丢失';
    });
    this.setState(init.h0, init.hu0, init.hv0);
  }

  /** Request a device, compile all pipelines and upload the initial state. */
  static async create(init: EngineInit): Promise<GpuEngine> {
    const gpu = navigator.gpu;
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('没有可用的 WebGPU 适配器');
    const L = adapter.limits;
    if (L.maxStorageBuffersPerShaderStage < 8) throw new Error('GPU 存储缓冲区数量不足');
    const cells = (init.grid.nx + 1) * init.grid.ny + init.grid.nx * (init.grid.ny + 1);
    const need = 16 * cells;
    if (need > L.maxStorageBufferBindingSize) throw new Error('网格过大，超出 GPU 缓冲区上限');
    const dev = await adapter.requestDevice({
      label: 'hydrosim',
      requiredLimits: {
        maxStorageBuffersPerShaderStage: Math.min(10, L.maxStorageBuffersPerShaderStage),
        maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
        maxBufferSize: L.maxBufferSize,
      },
    });
    const info = adapter.info;
    const label = `GPU · WebGPU（${[info?.vendor, info?.architecture, info?.description].filter((x) => x).join(' ') || '未知适配器'}）`;
    const compile = async (code: string, name: string, constants?: Record<string, number>): Promise<GPUComputePipeline> => {
      const module = dev.createShaderModule({ label: name, code });
      const ci = await module.getCompilationInfo();
      const errs = ci.messages.filter((m) => m.type === 'error');
      if (errs.length) throw new Error(`WGSL ${name}: ${errs.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('; ')}`);
      return dev.createComputePipelineAsync({ label: name, layout: 'auto', compute: { module, entryPoint: 'main', constants } });
    };
    const [bc, slopes, flux1, flux2a, flux2b, scalar, bflux, bfluxH, update0, update1, update2, stats, finalize, copyU0, pack, zline] = await Promise.all([
      compile(K.BC, 'bc'),
      compile(K.SLOPES, 'slopes'),
      compile(K.FLUX, 'flux1', { ORDER: 1, TRACK: 1 }),
      compile(K.FLUX, 'flux2a', { ORDER: 2, TRACK: 1 }),
      compile(K.FLUX, 'flux2b', { ORDER: 2, TRACK: 0 }),
      compile(K.SCALAR, 'scalar'),
      compile(K.BFLUX, 'bflux', { HALF: 0 }),
      compile(K.BFLUX, 'bfluxH', { HALF: 1 }),
      compile(K.UPDATE, 'update0', { STAGE: 0 }),
      compile(K.UPDATE, 'update1', { STAGE: 1 }),
      compile(K.UPDATE, 'update2', { STAGE: 2 }),
      compile(K.STATS, 'stats'),
      compile(K.FINALIZE, 'finalize'),
      compile(K.COPY_U0, 'copyU0'),
      compile(K.PACK, 'pack'),
      compile(K.ZLINE, 'zline'),
    ]);
    const eng = new GpuEngine(dev, label, init, { bc, slopes, flux1, flux2a, flux2b, scalar, bflux, bfluxH, update0, update1, update2, stats, finalize, copyU0, pack, zline });
    // a tiny warm-up batch validates pipelines and bind groups before reporting success
    await eng.advance(0, 1, false, 1);
    if (eng.lostReason) throw new Error(eng.lostReason);
    return eng;
  }

  get t(): number {
    return this._t;
  }
  get stepCount(): number {
    return this._steps;
  }

  // ------------------------------------------------------------------ configuration
  setState(h0: Float32Array, hu0?: Float32Array | null, hv0?: Float32Array | null): void {
    this.h0 = h0;
    const hd = this.params.hDry;
    const { nx, ny, NX, N } = this;
    const U = new Float32Array(4 * N);
    const env = new Float32Array(4 * this.nCells);
    let vol = 0;
    const ad = this.params.arrivalDepth;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const p = (j + 2) * NX + i + 2;
        const h = Math.max(0, h0[c]);
        U[4 * p] = h;
        if (h > hd) {
          if (hu0) U[4 * p + 1] = hu0[c];
          if (hv0) U[4 * p + 2] = hv0[c];
        }
        U[4 * p + 3] = this.z[c];
        vol += h;
        env[4 * c] = h;
        env[4 * c + 3] = h >= ad ? 0 : -1;
      }
    }
    const q = this.dev.queue;
    q.writeBuffer(this.buf.U, 0, U);
    q.writeBuffer(this.buf.ENV, 0, env);
    q.writeBuffer(this.buf.C, 0, new ArrayBuffer(K.CTRL_BYTES));
    this.volume0 = vol * this.dx * this.dy;
    this._t = 0;
    this._steps = 0;
    this.lastDt = 0;
    this.totals = { rain: 0, inflow: 0, infil: 0, clip: 0, bIn: 0, bOut: 0 };
    this.nextRecord = this.recordInterval;
    this.extra = [];
    this.dirtySeries = true;
    const init = this.initialRow();
    this.lastRow = init.row;
    this.lastStats = this.statsFromRow(init.row, init.wet, init.maxH, 0);
  }

  setParams(p: Partial<SolverParams>): void {
    this.params = { ...this.params, ...p };
    if (p.boundaries || p.sources || p.rainfall || p.links || p.lines || p.wind !== undefined) this.dirtySeries = true;
    if (p.manning !== undefined || p.manningField !== undefined) this.dirtyManning = true;
  }

  setExtraSources(s: SourceSpec[]): void {
    this.extra = s;
    this.dirtySeries = true;
  }

  setObservers(probes: ProbeSpec[], sections: SectionSpec[]): void {
    this.probes = probes;
    this.sections = sections;
    this.dirtyObs = true;
  }

  setRecordInterval(ri: number): void {
    this.recordInterval = ri;
    this.nextRecord = this._t + ri;
  }

  private writeBufferSized(name: string, data: Float32Array, usage: number): void {
    const bytes = Math.max(16, data.byteLength);
    const cur = this.buf[name];
    if (!cur || cur.size < bytes) {
      cur?.destroy();
      this.buf[name] = this.dev.createBuffer({ label: name, size: Math.ceil(bytes / 16) * 16, usage });
      this.dirtyGroups = true;
    }
    if (data.byteLength) this.dev.queue.writeBuffer(this.buf[name], 0, data);
  }

  /** Series (rain, boundary levels, source hydrographs) and source geometry. */
  private uploadSeries(): void {
    const P = this.params;
    const refs: { data: number[]; mode: number; n: number }[] = [];
    const rf = P.rainfall;
    if (rf && rf.enabled) refs.push({ data: flatten(rf.series), mode: rf.stepwise ? 1 : 0, n: rf.series.length });
    else refs.push({ data: [], mode: 0, n: 0 });
    for (const side of SIDES) {
      const b = P.boundaries[side];
      if (b.type === 'level') refs.push({ data: flatten(b.series), mode: 0, n: b.series.length });
      else if (b.type === 'tide' || b.type === 'ocean') {
        // sinusoid (mean, amplitude, period, phase); a missing period means a constant level
        const ok = b.amplitude !== 0 && b.period > 0;
        refs.push({ data: [b.mean, ok ? b.amplitude : 0, ok ? b.period : 1, b.phase], mode: 2, n: 2 });
      } else refs.push({ data: [], mode: 0, n: 0 });
    }
    const sources = [...P.sources, ...this.extra].slice(0, K.MAX_SOURCES - K.MAX_LINKS);
    for (const s of sources) refs.push({ data: flatten(s.series), mode: 0, n: s.series.length });
    const links = P.links.slice(0, K.MAX_LINKS);
    for (const L of links) refs.push(L.kind === 'pump' ? { data: flatten(L.series), mode: 0, n: L.series.length } : { data: [], mode: 0, n: 0 });
    const lines = P.lines.slice(0, K.MAX_LINES);
    for (const L of lines) refs.push({ data: flatten(L.series), mode: 0, n: L.series.length });
    // wind speed (last ref: index 5 + nSources + nLinks + nLines in the scalar kernel)
    refs.push(P.wind ? { data: flatten(P.wind.speed), mode: 0, n: P.wind.speed.length } : { data: [], mode: 0, n: 0 });
    const header = 1 + 4 * refs.length;
    const total = header + refs.reduce((a, r) => a + r.data.length, 0);
    const ser = new Float32Array(total);
    ser[0] = refs.length;
    let off = header;
    refs.forEach((r, k) => {
      ser[1 + 4 * k] = off;
      ser[2 + 4 * k] = r.n;
      ser[3 + 4 * k] = r.mode;
      ser.set(r.data, off);
      off += r.data.length;
    });
    this.writeBufferSized('SER', ser, BUF.S | BUF.CD);
    // source disks (same cell selection as the CPU solver)
    const { nx, ny, dx, dy } = this;
    const sp = new Float32Array(8 * Math.max(1, sources.length + links.length));
    sources.forEach((s, k) => {
      const r = Math.max(0, s.radius);
      let count = 0;
      const i0 = Math.max(0, Math.floor((s.x - r) / dx));
      const i1 = Math.min(nx - 1, Math.floor((s.x + r) / dx));
      const j0 = Math.max(0, Math.floor((s.y - r) / dy));
      const j1 = Math.min(ny - 1, Math.floor((s.y + r) / dy));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * dx - s.x;
          const cy = (j + 0.5) * dy - s.y;
          if (cx * cx + cy * cy <= r * r) count++;
        }
      }
      const fi = Math.min(nx - 1, Math.max(0, Math.floor(s.x / dx)));
      const fj = Math.min(ny - 1, Math.max(0, Math.floor(s.y / dy)));
      const area = Math.max(1, count) * dx * dy;
      sp.set([s.x, s.y, r * r, 1 / area, fj * nx + fi, count === 0 ? 1 : 0, 0, 0], 8 * k);
    });
    const pad = (c: number): number => {
      const i = c % nx;
      return ((c - i) / nx + 2) * this.NX + i + 2;
    };
    links.forEach((L, k) => {
      sp.set([L.a, L.b, pad(L.a), pad(L.b), L.kind === 'pump' ? 1 : 0, L.area, L.cd, 0], 8 * (sources.length + k));
    });
    this.writeBufferSized('SRCP', sp, BUF.S | BUF.CD);
    this.nSources = sources.length;
    this.nLinks = links.length;
    // gate / breach cells: (padded index, ground bed, line index); exact-size buffer (arrayLength in WGSL)
    const nLc = lines.reduce((a, L) => a + L.cells.length, 0);
    this.nLines = lines.length;
    this.nLineCells = nLc;
    if (nLc > 0) {
      const zl = new Float32Array(4 * nLc);
      let o = 0;
      lines.forEach((L, l) => {
        L.cells.forEach((c, k) => {
          zl.set([pad(c), L.zGround[k], l, L.mode === 'raise' ? 0 : L.mode === 'lower' ? 1 : 2], 4 * o);
          o++;
        });
      });
      this.buf.ZL?.destroy();
      this.buf.ZL = this.dev.createBuffer({ label: 'ZL', size: zl.byteLength, usage: BUF.S | BUF.CD });
      this.dev.queue.writeBuffer(this.buf.ZL, 0, zl);
      this.dirtyGroups = true;
    }
    this.dirtySeries = false;
  }

  /** Observer definitions (probe cells, section cells/weights) and record ring sizing. */
  private uploadObservers(): void {
    const { nx, NX } = this;
    const pad = (c: number): number => {
      const i = c % nx;
      const j = (c - i) / nx;
      return (j + 2) * NX + i + 2;
    };
    const P = this.probes.length;
    const S = this.sections.length;
    const head = P + 4 * S;
    const cellsTotal = this.sections.reduce((a, s) => a + s.cells.length, 0);
    const obs = new Float32Array(head + 2 * cellsTotal);
    this.probes.forEach((p, k) => (obs[k] = pad(p.cell)));
    let off = head;
    this.sections.forEach((s, k) => {
      obs.set([off, s.cells.length, s.nx, s.ny], P + 4 * k);
      s.cells.forEach((c, m) => {
        obs[off + 2 * m] = pad(c);
        obs[off + 2 * m + 1] = s.weights[m];
      });
      off += 2 * s.cells.length;
    });
    this.writeBufferSized('OBS', obs, BUF.S | BUF.CD);
    this.recFloats = K.REC_HEADER + 3 * P + S;
    const recBytes = 4 * this.recFloats * (MAX_STEPS + 2);
    if (!this.buf.REC || this.buf.REC.size < recBytes) {
      this.buf.REC?.destroy();
      this.buf.REC = this.dev.createBuffer({ label: 'REC', size: recBytes, usage: BUF.S | BUF.CS });
      this.dirtyGroups = true;
    }
    this.dirtyObs = false;
  }

  /** Per-cell Manning coefficient (uniform value replicated when no field is given). */
  private uploadManning(): void {
    const P = this.params;
    const n = new Float32Array(this.nCells);
    if (P.manningField && P.manningField.length === this.nCells) n.set(P.manningField);
    else n.fill(P.manning);
    if (!this.buf.NMAN) {
      this.buf.NMAN = this.dev.createBuffer({ label: 'NMAN', size: 4 * this.nCells, usage: BUF.S | BUF.CD });
      this.dirtyGroups = true;
    }
    this.dev.queue.writeBuffer(this.buf.NMAN, 0, n);
    this.dirtyManning = false;
  }

  private ensureOrder2(): void {
    if (this.order2Ready) return;
    this.buf.U0 = this.dev.createBuffer({ label: 'U0', size: 16 * this.N, usage: BUF.S });
    this.buf.SL = this.dev.createBuffer({ label: 'SL', size: 32 * this.N, usage: BUF.S });
    this.order2Ready = true;
    this.dirtyGroups = true;
  }

  private buildGroups(): void {
    const b = this.buf;
    if (!b.DUMMY2) b.DUMMY2 = this.dev.createBuffer({ label: 'DUMMY2', size: 64, usage: BUF.S });
    const bind = (name: PipeName, res: GPUBuffer[]): void => {
      this.groups[name] = this.dev.createBindGroup({
        label: name,
        layout: this.pipes[name].getBindGroupLayout(0),
        entries: res.map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    };
    // unused bindings (MUSCL slopes in first order, U0 outside Heun stage 2) get small dummy buffers
    bind('bc', [b.P, b.U, b.C]);
    bind('flux1', [b.P, b.U, b.DUMMY, b.F, b.R, b.C]);
    bind('scalar', [b.P, b.C, b.SER, b.DTH, b.IND, b.U, b.SRCP]);
    bind('bflux', [b.P, b.F, b.C, b.BACC]);
    bind('bfluxH', [b.P, b.F, b.C, b.BACC]);
    bind('update0', [b.P, b.U, b.DUMMY2, b.F, b.R, b.C, b.ENV, b.ACC, b.SRCP, b.NMAN]);
    if (b.ZL) bind('zline', [b.P, b.U, b.C, b.ZL]);
    bind('stats', [b.P, b.U, b.ACC, b.PART]);
    bind('finalize', [b.P, b.U, b.C, b.PART, b.BACC, b.OBS, b.REC]);
    bind('pack', [b.P, b.U, b.PACK]);
    if (this.order2Ready) {
      bind('slopes', [b.P, b.U, b.SL]);
      bind('flux2a', [b.P, b.U, b.SL, b.F, b.R, b.C]);
      bind('flux2b', [b.P, b.U, b.SL, b.F, b.R, b.C]);
      bind('update1', [b.P, b.U, b.DUMMY2, b.F, b.R, b.C, b.ENV, b.ACC, b.SRCP, b.NMAN]);
      bind('update2', [b.P, b.U, b.U0, b.F, b.R, b.C, b.ENV, b.ACC, b.SRCP, b.NMAN]);
      bind('copyU0', [b.P, b.U, b.U0]);
    }
    this.dirtyGroups = false;
  }

  private applyPending(): void {
    if (this.lostReason) throw new Error(this.lostReason);
    if (this.params.order === 2) this.ensureOrder2();
    if (this.dirtySeries) this.uploadSeries();
    if (this.dirtyManning) this.uploadManning();
    if (this.dirtyObs) this.uploadObservers();
    if (this.dirtyGroups) this.buildGroups();
  }

  private writeParams(tBase: number, tStopRel: number, steps: number, nextRecRel: number): void {
    const P = this.params;
    const ab = new ArrayBuffer(K.PARAMS_BYTES);
    const u = new Uint32Array(ab);
    const f = new Float32Array(ab);
    u[0] = this.nx;
    u[1] = this.ny;
    u[2] = this.NX;
    u[3] = this.N;
    u[4] = this.nXI;
    u[5] = this.nYI;
    u[6] = this.nCells;
    u[7] = this.nBnd;
    f[8] = this.dx;
    f[9] = this.dy;
    f[10] = P.gravity;
    f[11] = P.cfl;
    f[12] = P.maxDt;
    f[13] = P.hDry;
    f[14] = P.gravity * P.manning * P.manning;
    f[15] = P.velocityCap;
    f[16] = P.arrivalDepth;
    f[17] = tBase;
    f[18] = tStopRel;
    f[19] = this.recordInterval;
    f[20] = P.rainfall && P.rainfall.enabled ? Math.max(0, P.rainfall.infiltration) / 3.6e6 : 0;
    u[21] = P.rainfall && P.rainfall.enabled ? 1 : 0;
    f[22] = this.dx * this.dy;
    const code = (s: (typeof SIDES)[number]): number => {
      const t = P.boundaries[s].type;
      return t === 'wall' ? 0 : t === 'open' ? 1 : t === 'ocean' ? 3 : 2;
    };
    u[24] = code('west');
    u[25] = code('east');
    u[26] = code('south');
    u[27] = code('north');
    u[28] = steps;
    u[29] = this.probes.length;
    u[30] = this.sections.length;
    u[31] = this.recFloats;
    u[32] = this.nSources;
    u[33] = 1;
    u[34] = this.statsGroups;
    u[23] = this.nLinks;
    u[35] = this.nLines;
    // rotation, wind and open-sea currents (docs/ALGORITHMS.md §7, §8.4)
    f[36] = P.coriolis;
    u[37] = P.wind ? 1 : 0;
    if (P.wind) {
      const a = (P.wind.direction * Math.PI) / 180;
      f[38] = -Math.sin(a);
      f[39] = -Math.cos(a);
      f[48] = P.wind.densityRatio;
    }
    f[49] = Math.max(P.hDry, WIND_MIN_DEPTH);
    const vel = (b: BoundarySpec): [number, number] => (b.type === 'ocean' ? [b.u, b.v] : [0, 0]);
    f.set([...vel(P.boundaries.west), ...vel(P.boundaries.east), ...vel(P.boundaries.south), ...vel(P.boundaries.north)], 40);
    this.dev.queue.writeBuffer(this.buf.P, 0, ab);
    // per-batch control header (accumulators are batch-relative; the CPU keeps double-precision totals)
    const hdr = new ArrayBuffer(K.CTRL_LEVELS_OFFSET);
    const hf = new Float32Array(hdr);
    hf[8] = this.lastDt;
    hf[10] = nextRecRel;
    this.dev.queue.writeBuffer(this.buf.C, 0, hdr);
    const lv = new Float32Array(SIDES.map((s) => {
      const v = boundaryLevel(P.boundaries[s], tBase);
      return Number.isFinite(v) ? v : 0;
    }));
    this.dev.queue.writeBuffer(this.buf.C, K.CTRL_LEVELS_OFFSET, lv);
    if (this.nLines > 0) {
      const crest = new Float32Array(this.nLines);
      P.lines.slice(0, this.nLines).forEach((L, l) => (crest[l] = sampleSeries(L.series, tBase)));
      this.dev.queue.writeBuffer(this.buf.C, K.CTRL_LINECREST_OFFSET, crest);
    }
  }

  private ensureStaging(bytes: number): GPUBuffer {
    if (!this.staging || this.stagingSize < bytes) {
      this.staging?.destroy();
      this.stagingSize = Math.ceil(bytes / 256) * 256;
      this.staging = this.dev.createBuffer({ label: 'staging', size: this.stagingSize, usage: BUF.MR | BUF.CD });
    }
    return this.staging;
  }

  private planSteps(tStop: number, budgetMs: number, maxSteps: number): number {
    let n = this.msPerStep > 0 ? Math.floor(budgetMs / this.msPerStep) : 8;
    if (this.lastDt > 0 && Number.isFinite(tStop)) n = Math.min(n, Math.ceil(((tStop - this._t) / this.lastDt) * 1.05) + 2);
    return Math.max(1, Math.min(MAX_STEPS, maxSteps, n));
  }

  private encodeStep(pass: GPUComputePassEncoder, order: 1 | 2): void {
    const gB = Math.ceil(this.nBnd / 64);
    const gF = Math.ceil((this.nXI + this.nYI) / WG);
    const gC = this.statsGroups;
    const gN = Math.ceil(this.N / WG);
    const d = (name: PipeName, groups: number): void => {
      pass.setPipeline(this.pipes[name]);
      pass.setBindGroup(0, this.groups[name]);
      pass.dispatchWorkgroups(groups);
    };
    if (this.nLineCells > 0) d('zline', Math.ceil(this.nLineCells / 64));
    if (order === 1) {
      d('bc', gB);
      d('flux1', gF);
      d('scalar', 1);
      d('bflux', gB);
      d('update0', gC);
    } else {
      d('copyU0', gN);
      d('bc', gB);
      d('slopes', gN);
      d('flux2a', gF);
      d('scalar', 1);
      d('bfluxH', gB);
      d('update1', gC);
      d('bc', gB);
      d('slopes', gN);
      d('flux2b', gF);
      d('bfluxH', gB);
      d('update2', gC);
    }
    pass.setPipeline(this.pipes.stats);
    pass.setBindGroup(0, this.groups.stats);
    pass.dispatchWorkgroupsIndirect(this.buf.IND, 0);
    pass.setPipeline(this.pipes.finalize);
    pass.setBindGroup(0, this.groups.finalize);
    pass.dispatchWorkgroupsIndirect(this.buf.IND, 16);
  }

  // ------------------------------------------------------------------ time stepping
  async advance(tStop: number, budgetMs: number, wantFields: boolean, maxSteps = MAX_STEPS): Promise<AdvanceResult> {
    this.applyPending();
    const order = this.params.order;
    const tStart = this._t;
    const steps = this.planSteps(tStop, budgetMs, maxSteps);
    const tStopRel = Number.isFinite(tStop) ? tStop - tStart : 3.0e38;
    this.writeParams(tStart, tStopRel, steps, this.nextRecord - tStart);
    const enc = this.dev.createCommandEncoder({ label: 'batch' });
    enc.clearBuffer(this.buf.ACC);
    enc.clearBuffer(this.buf.BACC);
    const pass = enc.beginComputePass({ label: 'steps' });
    for (let s = 0; s < steps; s++) this.encodeStep(pass, order);
    if (wantFields) {
      pass.setPipeline(this.pipes.pack);
      pass.setBindGroup(0, this.groups.pack);
      pass.dispatchWorkgroups(this.statsGroups);
    }
    pass.end();
    const recBytes = 4 * this.recFloats;
    const dtOff = K.CTRL_BYTES;
    const recOff = dtOff + Math.ceil((4 * steps) / 16) * 16;
    const recCopy = recBytes * (steps + 1);
    const packOff = recOff + Math.ceil(recCopy / 16) * 16;
    const total = packOff + (wantFields ? 12 * this.nCells : 0);
    const st = this.ensureStaging(total);
    enc.copyBufferToBuffer(this.buf.C, 0, st, 0, K.CTRL_BYTES);
    enc.copyBufferToBuffer(this.buf.DTH, 0, st, dtOff, 4 * steps);
    enc.copyBufferToBuffer(this.buf.REC, 0, st, recOff, recCopy);
    if (wantFields) enc.copyBufferToBuffer(this.buf.PACK, 0, st, packOff, 12 * this.nCells);
    const t0 = performance.now();
    this.dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ, 0, total);
    const ab = st.getMappedRange(0, total).slice(0);
    st.unmap();
    const elapsed = performance.now() - t0;
    if (this.lostReason) throw new Error(this.lostReason);
    const per = elapsed / steps;
    this.msPerStep = this.msPerStep > 0 ? 0.7 * this.msPerStep + 0.3 * per : per;

    const cu = new Uint32Array(ab, 0, K.CTRL_BYTES / 4);
    const cf = new Float32Array(ab, 0, K.CTRL_BYTES / 4);
    const stepsDone = cu[3];
    const recCount = Math.min(cu[4], steps + 1);
    const dts = new Float32Array(ab, dtOff, steps);
    const cum = new Float64Array(steps);
    let acc = 0;
    for (let k = 0; k < steps; k++) {
      acc += dts[k];
      cum[k] = acc;
      if (dts[k] > 0) this.lastDt = dts[k];
    }
    const span = Math.max(1e-9, Math.abs(tStop - tStart));
    const snap = (t: number): number => (Number.isFinite(tStop) && Math.abs(t - tStop) <= 1e-6 * span ? tStop : t);
    const tEnd = snap(tStart + acc);
    const base = { ...this.totals };
    const records: RecordRow[] = [];
    let last: { row: RecordRow; rec: Float32Array } | null = null;
    for (let r = 0; r < recCount; r++) {
      const rec = new Float32Array(ab, recOff + r * recBytes, this.recFloats);
      const si = Math.round(rec[0]);
      const tr = si >= 0 && si < steps ? snap(tStart + cum[si]) : tEnd;
      const row = this.rowFrom(rec, tr, base);
      if ((Math.round(rec[12]) & 1) !== 0) records.push(row);
      last = { row, rec };
    }
    this._t = tEnd;
    this._steps += stepsDone;
    this.nextRecord = tStart + cf[10];
    if (last) {
      const a = this.dx * this.dy;
      this.totals = {
        rain: base.rain + last.rec[3],
        inflow: base.inflow + last.rec[4],
        infil: base.infil + last.rec[5] * a,
        clip: base.clip + last.rec[6] * a,
        bIn: base.bIn + last.rec[7],
        bOut: base.bOut + last.rec[8],
      };
      last.row.t = tEnd;
      this.lastRow = last.row;
      this.lastStats = this.statsFromRow(last.row, last.rec[9], last.rec[10], last.rec[11]);
    }
    let fields: Fields | undefined;
    if (wantFields) {
      const all = new Float32Array(ab, packOff, 3 * this.nCells);
      const n = this.nCells;
      fields = { h: all.slice(0, n), u: all.slice(n, 2 * n), v: all.slice(2 * n, 3 * n) };
    }
    return { records, fields };
  }

  private rowFrom(rec: Float32Array, t: number, base: GpuEngine['totals']): RecordRow {
    const a = this.dx * this.dy;
    const P = this.probes.length;
    const volume = rec[2] * a;
    const rain = base.rain + rec[3];
    const inflow = base.inflow + rec[4];
    const infiltration = base.infil + rec[5] * a;
    const boundaryIn = base.bIn + rec[7];
    const boundaryOut = base.bOut + rec[8];
    const probes: [number, number, number][] = [];
    for (let k = 0; k < P; k++) probes.push([rec[16 + 3 * k], rec[17 + 3 * k], rec[18 + 3 * k]]);
    const sections: number[] = [];
    for (let k = 0; k < this.sections.length; k++) sections.push(rec[16 + 3 * P + k]);
    return {
      t,
      probes,
      sections,
      volume,
      rain,
      inflow,
      infiltration,
      boundaryIn,
      boundaryOut,
      wetArea: rec[9] * a,
      massError: volume - (this.volume0 + rain + inflow + boundaryIn - infiltration - boundaryOut),
      pids: this.probes.map((p) => p.id),
      sids: this.sections.map((q) => q.id),
    };
  }

  private statsFromRow(row: RecordRow, wetCells = 0, maxH = 0, maxV = 0): EngineStats {
    return {
      t: this._t,
      step: this._steps,
      dt: this.lastDt,
      volume: row.volume,
      volume0: this.volume0,
      rain: row.rain,
      inflow: row.inflow,
      infiltration: row.infiltration,
      boundaryIn: row.boundaryIn,
      boundaryOut: row.boundaryOut,
      clipped: this.totals.clip,
      massError: row.massError,
      wetCells,
      maxH,
      maxV,
    };
  }

  private initialRow(): { row: RecordRow; wet: number; maxH: number } {
    const ad = this.params.arrivalDepth;
    let wet = 0;
    let maxH = 0;
    for (let k = 0; k < this.h0.length; k++) {
      const h = this.h0[k];
      if (h >= ad) wet++;
      if (h > maxH) maxH = h;
    }
    const row: RecordRow = {
      t: 0,
      probes: this.probes.map((p) => {
        const h = Math.max(0, this.h0[p.cell]);
        return [h, this.z[p.cell] + h, 0] as [number, number, number];
      }),
      sections: this.sections.map(() => 0),
      volume: this.volume0,
      rain: 0,
      inflow: 0,
      infiltration: 0,
      boundaryIn: 0,
      boundaryOut: 0,
      wetArea: wet * this.dx * this.dy,
      massError: 0,
      pids: this.probes.map((p) => p.id),
      sids: this.sections.map((q) => q.id),
    };
    return { row, wet, maxH };
  }

  private emptyStats(): EngineStats {
    return { t: 0, step: 0, dt: 0, volume: 0, volume0: 0, rain: 0, inflow: 0, infiltration: 0, boundaryIn: 0, boundaryOut: 0, clipped: 0, massError: 0, wetCells: 0, maxH: 0, maxV: 0 };
  }
  private emptyRow(): RecordRow {
    return { t: 0, probes: [], sections: [], volume: 0, rain: 0, inflow: 0, infiltration: 0, boundaryIn: 0, boundaryOut: 0, wetArea: 0, massError: 0 };
  }

  // ------------------------------------------------------------------ read-back
  async fields(): Promise<Fields> {
    this.applyPending();
    const enc = this.dev.createCommandEncoder({ label: 'fields' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipes.pack);
    pass.setBindGroup(0, this.groups.pack);
    pass.dispatchWorkgroups(this.statsGroups);
    pass.end();
    const bytes = 12 * this.nCells;
    const st = this.ensureStaging(bytes);
    enc.copyBufferToBuffer(this.buf.PACK, 0, st, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ, 0, bytes);
    const all = new Float32Array(st.getMappedRange(0, bytes).slice(0));
    st.unmap();
    const n = this.nCells;
    return { h: all.slice(0, n), u: all.slice(n, 2 * n), v: all.slice(2 * n, 3 * n) };
  }

  async envelopes(): Promise<EnvelopeData> {
    const bytes = 16 * this.nCells;
    const st = this.ensureStaging(bytes);
    const enc = this.dev.createCommandEncoder({ label: 'envelopes' });
    enc.copyBufferToBuffer(this.buf.ENV, 0, st, 0, bytes);
    this.dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ, 0, bytes);
    const all = new Float32Array(st.getMappedRange(0, bytes).slice(0));
    st.unmap();
    const n = this.nCells;
    const maxH = new Float32Array(n);
    const maxV = new Float32Array(n);
    const maxHaz = new Float32Array(n);
    const arrival = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      maxH[c] = all[4 * c];
      maxV[c] = all[4 * c + 1];
      maxHaz[c] = all[4 * c + 2];
      arrival[c] = all[4 * c + 3];
    }
    return { maxH, maxV, maxHaz, arrival };
  }

  stats(): EngineStats {
    return { ...this.lastStats, t: this._t, step: this._steps, dt: this.lastDt };
  }

  currentRecord(): RecordRow {
    return { ...this.lastRow, t: this._t };
  }

  dispose(): void {
    for (const b of Object.values(this.buf)) b.destroy();
    this.staging?.destroy();
    this.dev.destroy();
  }
}
