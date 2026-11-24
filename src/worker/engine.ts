/**
 * Solver engines behind a common asynchronous interface:
 *  - CpuEngine: the double-precision TypeScript solver (src/core/solver.ts)
 *  - GpuEngine: WebGPU compute shaders (src/gpu/gpuEngine.ts), loaded on demand
 */
import { SWESolver, type GridSpec, type SolverParams, type SourceSpec } from '../core/solver';
import type { ProbeSpec, RecordRow, SectionSpec } from './protocol';

import type { EnginePref } from './protocol';
export type { EnginePref };

export interface Fields {
  h: Float32Array;
  u: Float32Array;
  v: Float32Array;
}

export interface EnvelopeData {
  maxH: Float32Array;
  maxV: Float32Array;
  maxHaz: Float32Array;
  arrival: Float32Array;
}

export interface EngineStats {
  t: number;
  step: number;
  dt: number;
  volume: number;
  volume0: number;
  rain: number;
  inflow: number;
  infiltration: number;
  boundaryIn: number;
  boundaryOut: number;
  clipped: number;
  massError: number;
  wetCells: number;
  maxH: number;
  maxV: number;
}

export interface AdvanceResult {
  records: RecordRow[];
  /** Fields at the end of the batch (when requested). */
  fields?: Fields;
}

export interface EngineInit {
  grid: GridSpec;
  z: Float32Array;
  h0: Float32Array;
  /** Initial unit discharges hu, hv (interior, row-major); zero when absent. */
  hu0?: Float32Array | null;
  hv0?: Float32Array | null;
  params: SolverParams;
  recordInterval: number;
  probes: ProbeSpec[];
  sections: SectionSpec[];
}

export interface Engine {
  readonly kind: 'cpu' | 'gpu';
  readonly label: string;
  readonly t: number;
  readonly stepCount: number;
  /** Reset to an initial state (interior, row-major); clears clocks, accumulators and envelopes. */
  setState(h0: Float32Array, hu0?: Float32Array | null, hv0?: Float32Array | null): void;
  setParams(p: Partial<SolverParams>): void;
  setExtraSources(s: SourceSpec[]): void;
  setObservers(probes: ProbeSpec[], sections: SectionSpec[]): void;
  setRecordInterval(ri: number): void;
  /**
   * Advance towards tStop (absolute time) for roughly budgetMs of wall-clock time (or at most maxSteps steps).
   * Returns the time-series records produced on the way.
   */
  advance(tStop: number, budgetMs: number, wantFields: boolean, maxSteps?: number): Promise<AdvanceResult>;
  fields(): Promise<Fields>;
  envelopes(): Promise<EnvelopeData>;
  stats(): EngineStats;
  /** Record of the current state (t = engine time). */
  currentRecord(): RecordRow;
  dispose(): void;
}

/** CPU engine: the reference double-precision solver. */
export class CpuEngine implements Engine {
  readonly kind = 'cpu' as const;
  readonly label = 'CPU · Web Worker（双精度）';
  private solver: SWESolver;
  private probes: ProbeSpec[];
  private sections: SectionSpec[];
  private recordInterval: number;
  private nextRecord = 0;

  constructor(init: EngineInit) {
    this.solver = new SWESolver(init.grid, init.z, init.params);
    this.probes = init.probes;
    this.sections = init.sections;
    this.recordInterval = init.recordInterval;
    this.setState(init.h0, init.hu0, init.hv0);
  }

  get t(): number {
    return this.solver.t;
  }
  get stepCount(): number {
    return this.solver.stepCount;
  }

  setState(h0: Float32Array, hu0?: Float32Array | null, hv0?: Float32Array | null): void {
    this.solver.setState(h0, hu0, hv0);
    this.solver.setExtraSources([]);
    this.nextRecord = this.recordInterval;
  }
  setParams(p: Partial<SolverParams>): void {
    this.solver.setParams(p);
  }
  setExtraSources(s: SourceSpec[]): void {
    this.solver.setExtraSources(s);
  }
  setObservers(probes: ProbeSpec[], sections: SectionSpec[]): void {
    this.probes = probes;
    this.sections = sections;
  }
  setRecordInterval(ri: number): void {
    this.recordInterval = ri;
    this.nextRecord = this.solver.t + ri;
  }

  async advance(tStop: number, budgetMs: number, wantFields: boolean, maxSteps = Infinity): Promise<AdvanceResult> {
    const s = this.solver;
    const t0 = performance.now();
    const records: RecordRow[] = [];
    let n = 0;
    while (s.t < tStop - 1e-9 && n < maxSteps) {
      const limit = tStop - s.t;
      s.step(limit > 1e-9 ? limit : Infinity);
      n++;
      if (s.t >= this.nextRecord - 1e-9) {
        records.push(this.currentRecord());
        while (this.nextRecord <= s.t + 1e-9) this.nextRecord += this.recordInterval;
      }
      if ((n & 3) === 0 && performance.now() - t0 >= budgetMs) break;
    }
    if (Math.abs(s.t - tStop) < 1e-9) s.t = tStop;
    return { records, fields: wantFields ? this.fieldsSync() : undefined };
  }

  private fieldsSync(): Fields {
    const h = this.solver.depthF32();
    const [u, v] = this.solver.velocityF32();
    return { h, u, v };
  }
  async fields(): Promise<Fields> {
    return this.fieldsSync();
  }
  async envelopes(): Promise<EnvelopeData> {
    const s = this.solver;
    return { maxH: s.maxH.slice(), maxV: s.maxV.slice(), maxHaz: s.maxHaz.slice(), arrival: s.arrival.slice() };
  }

  stats(): EngineStats {
    const s = this.solver;
    const mb = s.massBalance();
    return {
      t: s.t,
      step: s.stepCount,
      dt: s.lastDt,
      volume: mb.volume,
      volume0: mb.volume0,
      rain: mb.rain,
      inflow: mb.inflow,
      infiltration: mb.infiltration,
      boundaryIn: mb.boundaryIn,
      boundaryOut: mb.boundaryOut,
      clipped: mb.clipped,
      massError: mb.error,
      wetCells: s.wetCells,
      maxH: s.curMaxH,
      maxV: s.curMaxV,
    };
  }

  currentRecord(): RecordRow {
    const s = this.solver;
    const nx = s.nx;
    const probes: [number, number, number][] = this.probes.map((p) => {
      const i = p.cell % nx;
      const j = (p.cell - i) / nx;
      const c = s.cellState(i, j);
      return [c.h, c.z + c.h, Math.hypot(c.u, c.v)];
    });
    const sections = this.sections.map((q) => {
      let Q = 0;
      for (let k = 0; k < q.cells.length; k++) {
        const c = q.cells[k];
        const i = c % nx;
        const j = (c - i) / nx;
        const p = s.idx(i, j);
        Q += (s.hu[p] * q.nx + s.hv[p] * q.ny) * q.weights[k];
      }
      return Q;
    });
    const mb = s.massBalance();
    return {
      t: s.t,
      probes,
      sections,
      volume: mb.volume,
      rain: mb.rain,
      inflow: mb.inflow,
      infiltration: mb.infiltration,
      boundaryIn: mb.boundaryIn,
      boundaryOut: mb.boundaryOut,
      wetArea: s.wetCells * s.dx * s.dy,
      massError: mb.error,
      pids: this.probes.map((p) => p.id),
      sids: this.sections.map((q) => q.id),
    };
  }

  dispose(): void {
    /* garbage collected */
  }
}

/** Create the preferred engine; WebGPU failures fall back to the CPU engine with an explanatory note. */
export async function createEngine(pref: EnginePref, init: EngineInit): Promise<{ engine: Engine; note?: string }> {
  let note: string | undefined;
  if (pref !== 'cpu') {
    const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
    if (gpu) {
      try {
        const { GpuEngine } = await import('../gpu/gpuEngine');
        const engine = await GpuEngine.create(init);
        return { engine };
      } catch (err) {
        note = `WebGPU 初始化失败（${(err as Error)?.message ?? err}），已回退到 CPU 引擎`;
      }
    } else {
      note = '当前浏览器不支持 WebGPU，已使用 CPU 引擎';
    }
  }
  return { engine: new CpuEngine(init), note };
}
