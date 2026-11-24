import type { GridSpec, SolverParams } from '../core/solver';

export interface ProbeSpec {
  id: string;
  /** Interior cell index j*nx+i */
  cell: number;
}

export interface SectionSpec {
  id: string;
  cells: number[];
  weights: number[];
  nx: number;
  ny: number;
}

export interface SimStats {
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
  stepsPerSec: number;
  simPerSec: number;
  running: boolean;
  finished: boolean;
  engine: 'cpu' | 'gpu';
}

export type EnginePref = 'auto' | 'cpu' | 'gpu';

export interface EngineInfo {
  kind: 'cpu' | 'gpu';
  label: string;
  /** Why the preferred engine is not used (fallback), if any. */
  note?: string;
}

/** One time-series record. probes[k] = [depth, water surface elevation, speed]. */
export interface RecordRow {
  t: number;
  probes: [number, number, number][];
  sections: number[];
  volume: number;
  rain: number;
  inflow: number;
  infiltration: number;
  boundaryIn: number;
  boundaryOut: number;
  wetArea: number;
  massError: number;
  /** Observer ids the probe/section values refer to (set by the engine that produced the row). */
  pids?: string[];
  sids?: string[];
}

export interface InitMessage {
  type: 'init';
  /** Incremented by the main thread at each init; echoed on every worker message. */
  epoch: number;
  grid: GridSpec;
  z: Float32Array;
  h0: Float32Array;
  /** Initial unit discharges (optional, zero when absent). */
  hu0?: Float32Array | null;
  hv0?: Float32Array | null;
  params: SolverParams;
  duration: number;
  outputInterval: number;
  recordInterval: number;
  probes: ProbeSpec[];
  sections: SectionSpec[];
  engine: EnginePref;
}

export type MainToWorker =
  | InitMessage
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'step'; count: number }
  | { type: 'reset' }
  | { type: 'params'; params: Partial<SolverParams>; duration?: number; outputInterval?: number; recordInterval?: number }
  | { type: 'speed'; simPerSec: number }
  | { type: 'observers'; probes: ProbeSpec[]; sections: SectionSpec[] }
  | { type: 'ack' }
  | { type: 'envelopes' }
  | { type: 'pour'; x: number; y: number; radius: number; rate: number }
  | { type: 'setDepth'; h: Float32Array; hu?: Float32Array | null; hv?: Float32Array | null }
  | { type: 'engine'; pref: EnginePref };

export type WorkerToMain = { epoch?: number } & (
  | { type: 'ready'; stats: SimStats; engine: EngineInfo }
  | { type: 'frame'; stats: SimStats; h: Float32Array; u: Float32Array; v: Float32Array; records: RecordRow[]; probeIds: string[]; sectionIds: string[]; reset?: boolean }
  | { type: 'output'; t: number; h: Float32Array; u: Float32Array; v: Float32Array }
  | { type: 'envelopes'; maxH: Float32Array; maxV: Float32Array; maxHaz: Float32Array; arrival: Float32Array; t: number }
  | { type: 'state'; running: boolean; finished: boolean }
  | { type: 'error'; message: string }
);
